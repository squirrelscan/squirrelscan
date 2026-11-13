// Shared rows for the report-only Host section (#10): resolved addresses, GeoIP country, connect latency.
// Never scored.
import type { ReportHost } from "./types";

export interface HostRow {
  key: "host" | "ipv4" | "ipv6" | "country" | "latency" | "geoip";
  label: string;
  value: string;
}

/** The text a renderer shows for the country row: an edge country is never presented as the origin's. */
export function hostCountryRow(host: ReportHost): HostRow | null {
  const c = host.country;
  if (!c) return null;
  const where = `${c.name} (${c.code})`;
  if (c.location === "edge") {
    return {
      key: "country",
      label: "Edge location",
      value: `${where}, edge/anycast address of ${c.edge?.name ?? "the CDN"}; not the origin's location`,
    };
  }
  return { key: "country", label: "Hosting country", value: where };
}

export function hostRows(host: ReportHost): HostRow[] {
  const rows: HostRow[] = [{ key: "host", label: "Host", value: host.host }];
  if (host.addresses.ipv4.length > 0) rows.push({ key: "ipv4", label: "IPv4", value: host.addresses.ipv4.join(", ") });
  if (host.addresses.ipv6.length > 0) rows.push({ key: "ipv6", label: "IPv6", value: host.addresses.ipv6.join(", ") });
  const country = hostCountryRow(host);
  if (country) rows.push(country);
  if (host.latency) {
    const l = host.latency;
    rows.push({
      key: "latency",
      label: "Connect time",
      value: `${l.ms} ms (TCP connect to ${l.address.includes(":") ? `[${l.address}]` : l.address}:${l.port}, not an ICMP ping)`,
    });
  }
  if (country && host.geoipSnapshot) {
    rows.push({ key: "geoip", label: "GeoIP", value: `DB-IP.com Lite ${host.geoipSnapshot} (CC BY 4.0)` });
  }
  return rows;
}
