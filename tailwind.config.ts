import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
      // 下拉面板的展开动画。向上弹和向下弹各一个 —— 位移方向跟着面板走，
      // 否则面板从上方展开却向下位移，看着像"弹错方向"。
      keyframes: {
        "select-down": {
          from: { opacity: "0", transform: "translateY(-4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "select-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "select-down": "select-down 130ms ease-out",
        "select-up": "select-up 130ms ease-out",
      },
    },
  },
  plugins: [],
  darkMode: "class",
};

export default config;
