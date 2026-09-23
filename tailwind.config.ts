import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        paper: "#EEF0E7",
        panel: "#E4E7DB",
        ink: "#1A231F",
        inksoft: "#57614F",
        line: "#C7CCB9",
        amber: "#C97B25",
        ambersoft: "#F2DEC0",
        teal: "#2C6E68",
        tealsoft: "#D6E6E0",
        rust: "#AD4536",
        rustsoft: "#EFD7CF",
      },
    },
  },
  plugins: [],
};
export default config;
