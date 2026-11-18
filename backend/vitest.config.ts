import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    fileParallelism: !process.env.FIRESTORE_EMULATOR_HOST,
  },
});
