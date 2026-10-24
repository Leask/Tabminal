import assert from 'node:assert/strict';
import { it } from 'node:test';
import { normalizeAgentCommands, rankAgentCommands }
    from '../public/modules/agent-commands.js';

it('places skills after basic commands without losing or mutating entries', () => {
    const source = [
        { name: '$box:contract', description: 'Contracts' },
        { name: 'status' },
        { name: '$box:intake' },
        { name: 'review', input: { hint: 'instructions' } }
    ];
    const before = structuredClone(source);
    const commands = normalizeAgentCommands(source);
    assert.deepEqual(commands.map(({ name }) => name), [
        'status', 'review', '$box:contract', '$box:intake'
    ]);
    assert.equal(commands[1].inputHint, 'instructions');
    assert.equal(commands[2].description, 'Contracts');
    assert.deepEqual(source, before);
});

it('ranks basic commands before alphabetically earlier skills in the menu', () => {
    const commands = normalizeAgentCommands([
        { name: '$box:intake' }, { name: 'status' },
        { name: '$box:contract' }, { name: 'review' },
        { name: 'resume' }
    ]);
    const before = structuredClone(commands);
    assert.deepEqual(rankAgentCommands(commands).map(({ name }) => name), [
        'resume', 'review', 'status', '$box:contract', '$box:intake'
    ]);
    assert.deepEqual(commands, before);
});

it('preserves search relevance within each command group', () => {
    const commands = normalizeAgentCommands([
        { name: '$box:review' }, { name: 'branch-review' },
        { name: 'review-commit' }, { name: 'review' }, { name: 'status' }
    ]);
    assert.deepEqual(
        rankAgentCommands(commands, 'REVIEW').map(({ name }) => name),
        ['review', 'review-commit', 'branch-review', '$box:review']
    );
    assert.deepEqual(
        rankAgentCommands(commands, '$box').map(({ name }) => name),
        ['$box:review']
    );
    assert.deepEqual(rankAgentCommands(commands, 'missing'), []);
});

it('retains all skills and keeps basic commands ahead of menu limits', () => {
    const skills = Array.from({ length: 20 }, (_, index) => ({
        name: `$skill-${index}`
    }));
    const commands = normalizeAgentCommands([
        ...skills, { name: 'status' }, { name: 'resume' }
    ]);
    const ranked = rankAgentCommands(commands);
    assert.equal(ranked.length, 22);
    assert.deepEqual(ranked.slice(0, 2).map(({ name }) => name), [
        'resume', 'status'
    ]);
    assert.equal(rankAgentCommands(commands, '$skill').length, 20);
});

it('normalizes whitespace and ignores malformed command entries', () => {
    assert.deepEqual(normalizeAgentCommands(null), []);
    assert.deepEqual(normalizeAgentCommands([
        null, {}, { name: 42 }, { name: ' ' }, { name: ' status ' }
    ]), [{
        kind: 'command', name: 'status', description: '', inputHint: ''
    }]);
});
