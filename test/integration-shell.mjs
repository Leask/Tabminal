import test from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { TerminalManager } from "../src/terminal-manager.mjs";

async function waitForInitialExecution(session, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await delay(200);
        if (session.lastExecution) {
            return session.lastExecution.completedAt?.toISOString() ?? null;
        }
    }
    throw new Error("Shell never became ready");
}

async function runCommand(session, command) {
    const baseline = session.lastExecution?.completedAt?.toISOString() ?? null;
    session.pty.write(`${command}\n`);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        await delay(200);
        const entry = session.lastExecution;
        if (
            entry &&
            entry.command &&
            entry.command.includes(command.trim()) &&
            entry.completedAt?.toISOString() !== baseline
        ) {
            return entry;
        }
    }
    throw new Error("Timed out waiting for command execution");
}

function assertNoPromptArtifacts(output) {
    assert.ok(!/leask@/.test(output), 'should not contain user prompt');
    assert.ok(!/Flora/.test(output), 'should not contain host prompt');
    assert.ok(!(/[\u23a7\u23a9]/).test(output), 'should not contain prompt box glyphs');
}

test("captures real shell output without prompt noise", async () => {
    const manager = new TerminalManager();
    let session = null;
    try {
        session = manager.createSession();
        await waitForInitialExecution(session);
        const entry = await runCommand(session, "echo __TABMINAL_CAPTURE__");
        assert.strictEqual(entry.command.trim(), "echo __TABMINAL_CAPTURE__");
        assert.ok(entry.input.startsWith("echo __TABMINAL_CAPTURE__"));
        assert.ok(entry.output.startsWith("__TABMINAL_CAPTURE__"));
        assertNoPromptArtifacts(entry.output);
    } finally {
        if (session) {
            await manager.removeSession(session.id);
        }
        manager.dispose();
    }
});

test("strips terminal escape sequences from captured IO", async () => {
    const manager = new TerminalManager();
    let session = null;
    try {
        session = manager.createSession();
        await waitForInitialExecution(session);
        const entry = await runCommand(
            session,
            "python3 -c 'import sys; sys.stdout.write(\"\\x1b[35mline1\\r\\nline2\\r\\n\\x1b[0m\")'"
        );
        assert.strictEqual(
            entry.output,
            "line1\nline2",
            "should normalize CRLF pairs to LF"
        );
        assert.ok(
            !/\u001b/.test(entry.output),
            "should remove escape codes from output"
        );
        assert.ok(
            !/\u001b/.test(entry.input),
            "should remove escape codes from input"
        );
        assert.ok(
            !/\r/.test(entry.output),
            "should not contain carriage returns"
        );
        assert.ok(
            entry.input === "" || !/\s$/.test(entry.input),
            "should trim trailing whitespace from input"
        );
        assert.ok(
            entry.output === "" || !/\s$/.test(entry.output),
            "should trim trailing whitespace from output"
        );
    } finally {
        if (session) {
            await manager.removeSession(session.id);
        }
        manager.dispose();
    }
});

test("removing a session deletes persisted files after pending saves", async () => {
    const manager = new TerminalManager();
    let session = null;
    try {
        session = manager.createSession();
        await waitForInitialExecution(session);

        const sessionsDir = path.join(os.homedir(), ".tabminal", "sessions");
        const jsonPath = path.join(sessionsDir, `${session.id}.json`);
        const logPath = path.join(sessionsDir, `${session.id}.log`);
        const snapshotPath = path.join(sessionsDir, `${session.id}.snapshot`);

        session.resize(140, 42);
        await manager.removeSession(session.id);
        await delay(200);

        await assert.rejects(fs.stat(jsonPath), { code: "ENOENT" });
        await assert.rejects(fs.stat(logPath), { code: "ENOENT" });
        await assert.rejects(fs.stat(snapshotPath), { code: "ENOENT" });
    } finally {
        if (session) {
            await manager.removeSession(session.id);
        }
        manager.dispose();
    }
});

test("temporary HOME does not inherit host prompt command", async () => {
    const originalHome = process.env.HOME;
    const originalPromptCommand = process.env.PROMPT_COMMAND;
    const originalPs1 = process.env.PS1;
    const originalPs2 = process.env.PS2;
    const originalPs4 = process.env.PS4;
    const tempHome = await fs.mkdtemp(
        path.join(os.tmpdir(), "tabminal-shell-home-")
    );

    process.env.HOME = tempHome;
    process.env.PROMPT_COMMAND = "history -a; history -n; __bash_prompt";
    process.env.PS1 = "__HOST_PROMPT__";
    process.env.PS2 = "__HOST_CONT__";
    process.env.PS4 = "__HOST_TRACE__";

    const manager = new TerminalManager();
    let session = null;

    try {
        session = manager.createSession({
            cwd: tempHome
        });
        await waitForInitialExecution(session);
        await delay(300);

        assert.ok(
            !/__bash_prompt/.test(session.history),
            "should not leak inherited PROMPT_COMMAND into shell startup"
        );
        assert.ok(
            !/__HOST_PROMPT__/.test(session.history),
            "should not leak inherited prompt variables into shell startup"
        );

        const entry = await runCommand(session, "echo __TEMP_HOME_OK__");
        assert.ok(entry.output.includes("__TEMP_HOME_OK__"));
    } finally {
        if (session) {
            await manager.removeSession(session.id);
        }
        manager.dispose();

        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        if (originalPromptCommand === undefined) {
            delete process.env.PROMPT_COMMAND;
        } else {
            process.env.PROMPT_COMMAND = originalPromptCommand;
        }
        if (originalPs1 === undefined) {
            delete process.env.PS1;
        } else {
            process.env.PS1 = originalPs1;
        }
        if (originalPs2 === undefined) {
            delete process.env.PS2;
        } else {
            process.env.PS2 = originalPs2;
        }
        if (originalPs4 === undefined) {
            delete process.env.PS4;
        } else {
            process.env.PS4 = originalPs4;
        }
    }
});

test("managed sessions stay attachable until explicitly removed", async () => {
    const manager = new TerminalManager();
    const cwd = "/Users/leask/Documents/Tabminal";
    let session = null;
    try {
        session = manager.createManagedSession({
            cwd,
            spawnRequest: {
                command: "/bin/bash",
                args: ["-lc", 'printf "managed\\n"']
            },
            managed: {
                kind: "agent-terminal",
                agentId: "test-agent",
                agentLabel: "ACP Test Agent",
                acpSessionId: "acp-session-1",
                terminalId: "acp-terminal-1"
            }
        });

        const exitStatus = await session.waitForExit();
        assert.strictEqual(exitStatus.exitCode, 0);
        await delay(150);

        const listed = manager.listSessions().find(
            (item) => item.id === session.id
        );
        assert.ok(listed, "managed session should remain listed after exit");
        assert.strictEqual(listed.cwd, cwd);
        assert.strictEqual(listed.closed, true);
        assert.strictEqual(listed.exitStatus?.exitCode, 0);
        assert.strictEqual(listed.managed?.kind, "agent-terminal");
        assert.strictEqual(listed.managed?.agentLabel, "ACP Test Agent");

        const sessionsDir = path.join(os.homedir(), ".tabminal", "sessions");
        const jsonPath = path.join(sessionsDir, `${session.id}.json`);
        await assert.rejects(fs.stat(jsonPath), { code: "ENOENT" });

        await manager.removeSession(session.id);
        session = null;

        const removed = manager.listSessions().find((item) => item.id === listed.id);
        assert.strictEqual(removed, undefined);
    } finally {
        if (session) {
            await manager.removeSession(session.id);
        }
        manager.dispose();
    }
});
