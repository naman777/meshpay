import type { PoolConfig } from "pg";
export function postgresSchema() {
  const schema = process.env.DATABASE_SCHEMA || "meshpay";
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema))
    throw new Error("DATABASE_SCHEMA must be a lowercase SQL identifier");
  return schema;
}

export function postgresConfig(connectionString: string): PoolConfig {
  const ca = process.env.DATABASE_CA_CERT?.replaceAll("\\n", "\n");
  const verify = process.env.DATABASE_TLS_VERIFY !== "false";
  const url = new URL(connectionString);
  url.searchParams.delete("options");
  const options = `-c search_path=${postgresSchema()}`;
  if (!ca && verify) return { connectionString: url.toString(), options };
  // pg connection URI SSL options otherwise replace the supplied CA object.
  for (const name of [
    "sslmode",
    "ssl",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "uselibpqcompat",
  ])
    url.searchParams.delete(name);
  return {
    connectionString: url.toString(),
    options,
    ssl: { ...(ca ? { ca } : {}), rejectUnauthorized: ca ? true : verify },
  };
}
