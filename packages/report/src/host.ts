// Shared rows for the report-only Host section (#10): resolved addresses, GeoIP country, connect latency.
// Never scored.
import type { ReportHost } from "./types";

export interface HostRow {
  key: "host" | "ipv4" | "ipv6" | "edge" | "origin" | "country" | "latency" | "geoip";
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

/** The edge and origin rows: the edge provider is never shown as the origin, and an unknown origin says so. */
export function hostEdgeRows(host: ReportHost): HostRow[] {
  const e = host.edge;
  if (!e) return [];
  const via = e.matched.map((m) => (m === "ip-range" ? "published IP range" : m === "asn" ? `ASN${e.asn ? ` AS${e.asn}` : ""}` : "response headers")).join(", ");
  const broad = e.broad ? "; the range list covers all of Google Cloud, so this is not proof of a CDN" : "";
  const origin =
    e.origin.status === "edge-hosted"
      ? `none separate: ${e.name} is both edge and host`
      : e.origin.status === "identified"
        ? e.origin.name
        : "unknown";
  return [
    { key: "edge", label: "Edge", value: `${e.name} (matched by ${via}${broad})` },
    { key: "origin", label: "Origin", value: origin },
  ];
}

export function hostRows(host: ReportHost): HostRow[] {
  const rows: HostRow[] = [{ key: "host", label: "Host", value: host.host }];
  if (host.addresses.ipv4.length > 0) rows.push({ key: "ipv4", label: "IPv4", value: host.addresses.ipv4.join(", ") });
  if (host.addresses.ipv6.length > 0) rows.push({ key: "ipv6", label: "IPv6", value: host.addresses.ipv6.join(", ") });
  rows.push(...hostEdgeRows(host));
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
