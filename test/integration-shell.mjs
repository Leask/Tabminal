import test from "node:test";
import assert from "node:assert";
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
    try {
        const session = manager.createSession();
        await waitForInitialExecution(session);
        const entry = await runCommand(session, "echo __TABMINAL_CAPTURE__");
        assert.strictEqual(entry.command.trim(), "echo __TABMINAL_CAPTURE__");
        assert.ok(entry.input.startsWith("echo __TABMINAL_CAPTURE__"));
        assert.ok(entry.output.startsWith("__TABMINAL_CAPTURE__"));
        assertNoPromptArtifacts(entry.output);
    } finally {
        manager.dispose();
    }
});

test("strips terminal escape sequences from captured IO", async () => {
    const manager = new TerminalManager();
    try {
        const session = manager.createSession();
        await waitForInitialExecution(session);
        const entry = await runCommand(
            session,
            "python3 -c 'print(\"\\x1b[35m__TABMINAL_COLOR__\\x1b[0m\")'"
        );
        assert.ok(
            entry.output.startsWith("__TABMINAL_COLOR__"),
            "should keep plain output text"
        );
        assert.ok(
            !/\u001b/.test(entry.output),
            "should remove escape codes from output"
        );
        assert.ok(
            !/\u001b/.test(entry.input),
            "should remove escape codes from input"
        );
    } finally {
        manager.dispose();
    }
});
