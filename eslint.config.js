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
        rules: {}
    }
];
