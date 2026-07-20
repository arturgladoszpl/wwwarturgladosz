# arturgladosz.pl

Strona wizytówkowa Artura Gładosza zbudowana w [Astro](https://astro.build).
Statyczna strona — po zbudowaniu to zwykły HTML/CSS, serwowany bez żadnego backendu.

## Struktura

```
astro/
├─ src/
│  ├─ layouts/Base.astro        # <head>, czcionki, style globalne, obsługa hover
│  └─ pages/                    # każdy plik = jeden adres URL (bez .html)
│     ├─ index.astro            → /
│     ├─ nieruchomosci.astro    → /nieruchomosci
│     ├─ barak.astro            → /barak
│     ├─ niwiska.astro          → /niwiska
│     ├─ regulaminy.astro       → /regulaminy
│     ├─ regulamin-sklepu.astro → /regulamin-sklepu
│     └─ reklamacje-i-zwroty.astro → /reklamacje-i-zwroty
├─ public/images/               # zdjęcia (kopiowane 1:1 do strony)
├─ astro.config.mjs
└─ package.json
```

## Uruchomienie lokalne (opcjonalne)

Wymaga zainstalowanego [Node.js](https://nodejs.org) (wersja 18+).

```bash
npm install      # jednorazowo — pobiera zależności
npm run dev      # podgląd na http://localhost:4321
npm run build    # buduje gotową stronę do folderu dist/
```

## Wdrożenie na Cloudflare Pages (GitHub → Cloudflare)

1. Wrzuć **zawartość tego folderu** (`src/`, `public/`, `package.json`,
   `astro.config.mjs`, `.gitignore`) do repozytorium GitHub.
   Nie wrzucaj `node_modules/` ani `dist/` — są w `.gitignore`.
2. W panelu Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**,
   wybierz repozytorium.
3. Ustawienia budowania:
   - **Framework preset:** `Astro`
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
4. **Save and Deploy.** Cloudflare sam buduje stronę przy każdym commicie.
5. Domenę `arturgladosz.pl` podłącz w zakładce **Custom domains**.

## Edycja treści

- Teksty i dane (oferty, doświadczenie, regulaminy) są w blokach `---` na górze
  każdego pliku `.astro` oraz w samym HTML.
- Nowe zdjęcia wrzucaj do `public/images/` i odwołuj się przez `/images/nazwa.jpg`.
- Kolory: akcent `#2f5d74`, jasny akcent `#dde6ec`, tło `#f6f4ef`, tekst `#1c1b18`.
