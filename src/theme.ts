const systemDarkQuery = "(prefers-color-scheme: dark)";

function applySystemTheme(isDark: boolean) {
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
}

export function syncSystemTheme(query = window.matchMedia(systemDarkQuery)) {
  applySystemTheme(query.matches);

  const handleChange = (event: MediaQueryListEvent) => {
    applySystemTheme(event.matches);
  };

  query.addEventListener("change", handleChange);

  return () => {
    query.removeEventListener("change", handleChange);
  };
}
