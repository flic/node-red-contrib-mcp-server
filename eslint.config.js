'use strict';
// Minimal on purpose. This exists to catch one class of bug that nothing else here can:
// an identifier referenced but never declared. Such a line is valid syntax, so `node --check`
// passes it; it throws only when executed, and a Node-RED config node that throws during
// construction takes every node depending on it down with it. That is exactly how
// this package shipped two dead references straight to production in 1.7.1.
//
// So `no-undef` is the rule that matters and it is an error. `no-unused-vars` is a warning:
// a leftover binding is worth seeing — it is often the other half of a botched edit — but it
// breaks nothing, and a lint step that fails on tidiness gets disabled.
//
// Everything else is deliberately left alone. Style is not what this is for.

const globals = require('globals');

const nodeGlobals = { ...globals.node };

module.exports = [
    {
        // Runtime: what Node-RED loads. The reason this file exists.
        files: ['nodes/**/*.js', 'lib/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: nodeGlobals
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', { args: 'none' }]
        }
    },
    {
        files: ['test/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...nodeGlobals, ...globals.mocha }
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', { args: 'none' }]
        }
    },
    {
        // scripts/ are ES modules run by hand or from npm lifecycle hooks.
        files: ['scripts/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: nodeGlobals
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', { args: 'none' }]
        }
    }
];
