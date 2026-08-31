// @ts-check
import tseslint from 'typescript-eslint';

/** `node:test` returns promises from these; awaiting them is not the contract. */
const NODE_TEST_SAFE_CALLS = [
  {
    from: 'package',
    package: 'node:test',
    name: ['describe', 'it', 'test', 'suite', 'before', 'after', 'beforeEach', 'afterEach'],
  },
];

export default tseslint.config(
  {
    // The .mjs fixture is executed by a spawned process, not type-checked here.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.tmp/**', 'test/fixtures/*.mjs'],
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The whole point of picking typescript-eslint over Biome: this codebase is
      // fire-and-forget async I/O, where a dropped promise loses data silently.
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: NODE_TEST_SAFE_CALLS },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // The codebase uses `type` uniformly; object types are the minority case.
      '@typescript-eslint/consistent-type-definitions': 'off',
    },
  },
  {
    // Command entries and build scripts legitimately write to stdout.
    files: ['src/commands/**/*.ts', 'scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // A test asserting that a value the types call non-null really is there is
      // the test doing its job, not a redundant check.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
