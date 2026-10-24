function compareCommandGroups(left, right) {
    return Number(left.name.startsWith('$'))
        - Number(right.name.startsWith('$'));
}

export function normalizeAgentCommands(commands) {
    if (!Array.isArray(commands)) return [];
    return commands
        .map((command) => {
            const name = typeof command?.name === 'string'
                ? command.name.trim()
                : '';
            if (!name) return null;
            return {
                kind: 'command',
                name,
                description: command?.description || '',
                inputHint: command?.input?.hint || ''
            };
        })
        .filter(Boolean)
        .sort(compareCommandGroups);
}

export function rankAgentCommands(commands, query = '') {
    const search = String(query || '').toLowerCase();
    return commands
        .filter((command) => command.name.toLowerCase().includes(search))
        .sort((left, right) => {
            const group = compareCommandGroups(left, right);
            if (group !== 0) return group;
            const leftStarts = left.name.toLowerCase().startsWith(search);
            const rightStarts = right.name.toLowerCase().startsWith(search);
            if (leftStarts !== rightStarts) {
                return leftStarts ? -1 : 1;
            }
            return left.name.localeCompare(right.name);
        });
}
