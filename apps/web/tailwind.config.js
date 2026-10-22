/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#14171C",
        paper: "#F7F7F5",
        panel: "#FFFFFF",
        border: "#E4E4E1",
        signal: {
          DEFAULT: "#2151A8",
          soft: "#EAF0FB",
          dark: "#163D80",
        },
        verified: {
          DEFAULT: "#1F7A5C",
          soft: "#E7F4EF",
        },
        alert: {
          DEFAULT: "#B5730A",
          soft: "#FBF1E2",
        },
        risk: {
          DEFAULT: "#B23B3B",
          soft: "#FBEBEB",
        },
        slate: {
          DEFAULT: "#5B6472",
          soft: "#F0F1F2",
        },
      },
      fontFamily: {
        display: ['"Segoe UI Semibold"', "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
        body: ["ui-sans-serif", "system-ui", "-apple-system", '"Segoe UI"', "Roboto", "sans-serif"],
        mono: ['"SF Mono"', "ui-monospace", '"JetBrains Mono"', "Menlo", "monospace"],
      },
      borderRadius: {
        sm: "6px",
        md: "10px",
        lg: "14px",
      },
    },
  },
  plugins: [],
};
