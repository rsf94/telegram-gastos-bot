import "./globals.css";

export const metadata = {
  title: "Corte - Pagos TDC por mes",
  description: "Dashboard de cashflow mensual por tarjeta"
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
