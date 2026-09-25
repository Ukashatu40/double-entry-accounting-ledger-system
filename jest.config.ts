// jest.config.ts — add maxWorkers: 1 at the top level
import type { Config } from 'jest';

const sharedModuleNameMapper = {
  '^@config/(.*)$': '<rootDir>/src/config/$1',
  '^@common/(.*)$': '<rootDir>/src/common/$1',
  '^@database/(.*)$': '<rootDir>/src/database/$1',
  '^@accounts/(.*)$': '<rootDir>/src/accounts/$1',
  '^@ledger/(.*)$': '<rootDir>/src/ledger/$1',
  '^@transactions/(.*)$': '<rootDir>/src/transactions/$1',
  '^@fx/(.*)$': '<rootDir>/src/fx/$1',
  '^@reversals/(.*)$': '<rootDir>/src/reversals/$1',
  '^@audit/(.*)$': '<rootDir>/src/audit/$1',
  '^@reporting/(.*)$': '<rootDir>/src/reporting/$1',
  '^@health/(.*)$': '<rootDir>/src/health/$1',
  '^@auth/(.*)$': '<rootDir>/src/auth/$1',
};

const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  testTimeout: 60_000, // bumped from 30s — integration suites need headroom
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleNameMapper: sharedModuleNameMapper,
  collectCoverageFrom: ['src/**/*.(t|j)s', '!src/main.ts'],
  coverageDirectory: './docs/coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      lines: 80,
      functions: 80,
      branches: 70,
      statements: 80,
    },
  },
  watchman: false,

  // CRITICAL: forces every test FILE across every PROJECT to run one at a
  // time, in a single worker process. Integration tests share one physical
  // PostgreSQL test database — if two spec files run concurrently, one
  // file's cleanDatabase() TRUNCATE can wipe rows out from under another
  // file's in-flight assertions, causing deadlocks, "transaction not found"
  // errors, and balances/entry-counts that make no sense (data from two
  // tests bleeding together). Unit tests are unaffected by this (they
  // don't touch the DB) but running everything serially is a small,
  // acceptable cost for correctness.
  maxWorkers: 1,

  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/unit/**/*.spec.ts'],
      transform: {
        '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
      },
      moduleNameMapper: sharedModuleNameMapper,
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/integration/**/*.spec.ts'],
      transform: {
        '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
      },
      moduleNameMapper: sharedModuleNameMapper,
      setupFiles: ['<rootDir>/tests/integration/jest.setup.ts'],
    },
  ],
};

export default config;
