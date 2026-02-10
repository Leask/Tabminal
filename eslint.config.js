export default [
    {
        ignores: [
            'node_modules/**',
            '.history/**',
            'coverage/**',
            'public/icons/**'
        ]
    },
    {
        files: ['**/*.{js,mjs,cjs}'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module'
        },
        rules: {
            'no-unused-vars': ['error', {
                vars: 'all',
                args: 'after-used',
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrors: 'all',
                caughtErrorsIgnorePattern: '^_'
            }],
            'no-empty': ['error', {
                allowEmptyCatch: true
            }],
            'no-redeclare': 'error'
        }
    }
];
