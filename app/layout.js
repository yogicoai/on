export const metadata = {
  title: 'Yogibo 판매 분석',
  description: 'Cafe24 + 스마트스토어 판매 분석 대시보드',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://cdn.jsdelivr.net" />
        <link
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="/style.css?v=20260622n" />
      </head>
      <body>{children}</body>
    </html>
  );
}
