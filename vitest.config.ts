import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 家目录钉到临时目录，用例绝不读开发者本机 ~/.tokei 里的价目表与账本
    setupFiles: ["./test/pin-home.ts"],
  },
});
