import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@drishti/ui/styles.css";
import { App } from "./App";

/*
 * Dev-only guard. The Portal has no service worker, but another app served on
 * this origin can leave one behind: the reference demo
 * (drishti_robot_demo/frontend-next) also runs on :5173 and registers a
 * cache-first /sw.js that keeps answering Portal URLs such as /capture with
 * the demo's own stale, unstyled pages. Remove any worker + caches on this
 * origin, then reload once so this tab is no longer controlled by it.
 */
function removeForeignServiceWorkers() {
  if (!import.meta.env.DEV || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.getRegistrations().then(async (regs) => {
    if (!regs.length) return;
    await Promise.all(regs.map((r) => r.unregister()));
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    console.info(`[portal] removed ${regs.length} service worker(s) left on this origin by another app`);
    const flag = "drishti.portal.sw-cleaned";
    if (navigator.serviceWorker.controller && !sessionStorage.getItem(flag)) {
      sessionStorage.setItem(flag, "1");
      window.location.reload();
    }
  }).catch(() => undefined);
}

removeForeignServiceWorkers();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
