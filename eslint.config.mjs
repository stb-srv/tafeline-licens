import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: [
            'node_modules/**',
            'web/node_modules/**',
            'web/dist/**',
            'web/.astro/**',
            'data/**',
            '**/*.min.js',
        ],
    },
    js.configs.recommended,
    // Node.js ES modules
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.node },
        },
        rules: {
            'no-var': 'error',
            'prefer-const': 'warn',
            eqeqeq: ['warn', 'smart'],
            'no-unused-vars': [
                'warn',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrors: 'none',
                    ignoreRestSiblings: true,
                },
            ],
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-console': 'warn',
        },
    },
    // CLI-Skripte, Migrationen und Startup: Ausgabe auf der Konsole ist gewollt
    {
        files: [
            'init.js',
            'reset-admin.js',
            'restore.js',
            'setup-db.js',
            'server.js',
            'server/migrate.js',
            'server/migrations/**/*.js',
        ],
        rules: { 'no-console': 'off' },
    },
    // Astro-Frontend (Browser)
    {
        files: ['web/src/**/*.js'],
        languageOptions: {
            globals: { ...globals.browser },
        },
        rules: {
            'no-console': 'off',
        },
    },
    // Jest tests
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            globals: { ...globals.node, ...globals.jest },
        },
        rules: {
            'no-console': 'off',
        },
    },
];
