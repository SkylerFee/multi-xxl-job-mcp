// ESLint flat config。
//
// 设计原则：只开关能抓到真实缺陷的规则，风格类规则一律不引入（本项目没有格式化约定，
// 也不打算让 lint 变成争吵的场所）。每条开启的规则都对应一次真实发生过的错误或一次必然的失效路径。
//
// 背景：写配置插值正则时曾把 \{ 的转义写错，语法合法、tsc 抓不到、运行时静默不生效，
// 只有单元测试逮到。no-useless-escape 正是能在提交前直接指出来那条规则。
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // 构建产物与依赖不参与检查
    ignores: ["dist/**", "node_modules/**", "tmp/**", ".codegraph/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // —— 能抓到真实缺陷的规则 ——
      // 未使用的变量/参数：残留的重构碎片往往意味着漏改
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        // 解构排除写法 const { a, b, ...rest } = obj 里，a / b 天然不会被使用。
        // 用 ignoreRestSiblings（而不是 varsIgnorePattern: "^_"）是因为它只放过
        // 「带 rest 兄弟的解构属性」，普通未使用变量照样报错，不会留下大洞。
        ignoreRestSiblings: true,
      }],
      // 恒真/恒假条件：典型是调试后忘了删的 if (true) 或写错的比较
      "no-constant-condition": "error",
      // 正则里的控制字符：几乎总是误写（\x00-\x1f 被意外嵌进字符类）
      "no-control-regex": "error",
      // 多余的转义：本次会话真实踩过的坑 —— 把 A\{ 误写成 A\\{ 会让 { 变成量词，
      // 或把 $ 写成行尾锚点，整条插值正则静默失效；tsc 类型完全合法，抓不到
      "no-useless-escape": "error",
      // 永不重新赋值的 let：改用 const 才能让「这是常量」这件事在类型层面成立
      "prefer-const": ["error", { destructuring: "all" }],
      // 包装错误时丢弃原始错误：会抹掉 cause 与栈，排查时只剩一句转述。
      // 本次引入时它抓到 cli.ts 两处「重新 throw new Error(转述)」，已补上 { cause }。
      "preserve-caught-error": "error",
      // 不可达代码：throw/return 之后残留的语句是明确的逻辑错误
      "no-unreachable": "error",
      // 重复的 case 标签/对象键：后者静默覆盖前者
      "no-dupe-else-if": "error",
      "no-duplicate-case": "error",
      // async Promise executor / Promise 当作条件用：静默吞掉副作用
      "no-async-promise-executor": "error",
      "no-misleading-character-class": "error",
      // —— 风格类噪音，显式关闭 ——
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Node 环境下的脚本（不是浏览器）：只补标准库全局，不开额外的环境预设
    files: ["scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        __dirname: "readonly",
      },
    },
  },
  {
    // 测试文件：断言里常有「故意不用」的变量，放宽未使用检查但不关闭规则
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
    },
  },
);
