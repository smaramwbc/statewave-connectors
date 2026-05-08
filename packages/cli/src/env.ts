export interface StatewaveEnv {
  url?: string;
  apiKey?: string;
  tenantId?: string;
}

export function readStatewaveEnv(env: NodeJS.ProcessEnv = process.env): StatewaveEnv {
  return {
    url: env.STATEWAVE_URL,
    apiKey: env.STATEWAVE_API_KEY,
    tenantId: env.STATEWAVE_TENANT_ID,
  };
}
