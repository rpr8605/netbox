// Route definitions for the React console.
// Keep in sync with routes.tsx and the Fastify control plane.
export const ROUTES = {
  board: '/',
  alerts: '/alerts',
  alertDetail: (id: string) => `/alerts/${id}`,
  fleet: '/fleet',
  site: (id: string) => `/sites/${id}`,
  siteSupport: (id: string) => `/sites/${id}/support`,
  siteTopology: (id: string) => `/sites/${id}/topology`,
  routing: (siteId: string) => `/routing/${siteId}`,
} as const;
