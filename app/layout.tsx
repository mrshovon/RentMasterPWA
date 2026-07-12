import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "RentMaster Pro PWA",
  description: "Unified Backend Engine & Real Estate Logistics Portal Framework",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "sans-serif", background: "#f3f4f6" }}>
        {/* React Placeholder Shell Wrapper */}
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
          <header style={{ background: "#1e293b", color: "#fff", padding: "1rem" }}>
            <h1 style={{ margin: 0, fontSize: "1.25rem" }}>🏢 RentMaster Backend Pipeline</h1>
            <p style={{ margin: 0, fontSize: "0.85rem", color: "#94a3b8" }}>
              Status: Live & Operational (Phase 2, 3 & 4 Server Core Active)
            </p>
          </header>
          
          <main style={{ flex: 1, padding: "2rem" }}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}