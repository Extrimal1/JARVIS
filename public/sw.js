/* Jarvis service worker: Web Push for the Morning Briefing.
 * No caching here — push display + click-through only, so updates to
 * the app itself never get stuck behind a stale worker. */

self.addEventListener("push", (event) => {
  let data = { title: "J.A.R.V.I.S.", body: "", url: "/briefing", tag: undefined };

  try {
    if (event.data) {
      const parsed = event.data.json();
      data = {
        title: typeof parsed.title === "string" ? parsed.title : data.title,
        body: typeof parsed.body === "string" ? parsed.body : "",
        url: typeof parsed.url === "string" ? parsed.url : "/briefing",
        tag: typeof parsed.tag === "string" ? parsed.tag : undefined,
      };
    }
  } catch {
    // Keep the fallback content above; never show raw parse errors.
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body === "" ? "Dein Morgen-Briefing ist da." : data.body,
      tag: data.tag,
      icon: "/icons/icon.svg",
      badge: "/icons/icon.svg",
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const raw = event.notification.data;
  const url =
    raw !== null && typeof raw === "object" && typeof raw.url === "string"
      ? raw.url
      : "/briefing";

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window" });

      for (const client of windows) {
        if ("focus" in client && client.url.includes(url)) {
          return client.focus();
        }
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }

      return undefined;
    })(),
  );
});
