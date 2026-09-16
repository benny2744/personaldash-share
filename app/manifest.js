export default function manifest() {
  return {
    name: process.env.APP_NAME || "WorkDash",
    short_name: process.env.APP_NAME || "WorkDash",
    description: "Self-hosted workspace: chat, DingTalk, calendar, projects, kanban, meetings",
    start_url: "/chat",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0053dc",
    orientation: "any",
    scope: "/",
    icons: [
      {
        src: "/icons/icon-192x192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    categories: ["productivity", "utilities"],
  };
}
