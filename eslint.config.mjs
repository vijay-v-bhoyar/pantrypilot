import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
const config = [
  ...nextVitals,
  ...nextTypescript,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "output/**",
      "graphify-out/**",
      "next-env.d.ts",
      "playwright-report/**",
      "test-results/**",
      "coverage/**",
      ".data/**",
      "backups/**",
      "videos/**/assets/vendor/**",
    ],
  },
];
export default config;
