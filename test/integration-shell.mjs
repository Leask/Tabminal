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
