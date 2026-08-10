import type { SandboxNetwork } from "@blaxel/core";
import type { SandboxNetworkPolicy } from "eve/sandbox";

type EveNetworkRule = {
  readonly forwardURL?: string;
  readonly match?: unknown;
  readonly transform?: ReadonlyArray<{
    readonly headers?: Readonly<Record<string, string>>;
  }>;
};

type EveNetworkPolicyObject = {
  readonly allow?:
    | ReadonlyArray<string>
    | Readonly<Record<string, ReadonlyArray<EveNetworkRule>>>;
  readonly subnets?: {
    readonly allow?: ReadonlyArray<string>;
    readonly deny?: ReadonlyArray<string>;
  };
};

/** Convert eve's firewall shape into Blaxel's domain proxy configuration. */
export function toBlaxelNetworkPolicy(policy: SandboxNetworkPolicy): SandboxNetwork {
  if (policy === "allow-all") return {};
  if (policy === "deny-all") {
    return { proxy: { allowedDomains: [], routing: [] } };
  }

  const input = policy as EveNetworkPolicyObject;
  if ((input.subnets?.allow?.length ?? 0) > 0 || (input.subnets?.deny?.length ?? 0) > 0) {
    throw new Error(
      "The Blaxel eve backend does not support eve subnet allow or deny rules.",
    );
  }

  const entries = normalizeAllowEntries(input.allow);
  const allowAll = entries.some(([domain]) => domain === "*");
  const allowedDomains = allowAll ? undefined : entries.map(([domain]) => domain);
  const routing = entries.flatMap(([domain, rules], domainIndex) => {
    const headers: Record<string, string> = {};
    const secrets: Record<string, string> = {};

    rules.forEach((rule, ruleIndex) => {
      if (rule.match !== undefined) {
        throw new Error(
          `The Blaxel eve backend cannot apply a request match condition for ${domain}.`,
        );
      }
      if (rule.forwardURL !== undefined) {
        throw new Error(
          `The Blaxel eve backend cannot forward requests for ${domain} to another URL.`,
        );
      }
      rule.transform?.forEach((transform, transformIndex) => {
        Object.entries(transform.headers ?? {}).forEach(([header, value], headerIndex) => {
          const secretName = `eve-${domainIndex}-${ruleIndex}-${transformIndex}-${headerIndex}`;
          headers[header] = `{{SECRET:${secretName}}}`;
          secrets[secretName] = value;
        });
      });
    });

    if (Object.keys(headers).length === 0) return [];
    return [{ destinations: [domain], headers, secrets }];
  });

  return {
    proxy: {
      ...(allowedDomains === undefined ? {} : { allowedDomains }),
      routing,
    },
  };
}

function normalizeAllowEntries(
  allow: EveNetworkPolicyObject["allow"],
): ReadonlyArray<readonly [string, ReadonlyArray<EveNetworkRule>]> {
  if (allow === undefined) return [];
  if (Array.isArray(allow)) return allow.map((domain) => [domain, []] as const);
  return Object.entries(allow).map(([domain, rules]) => [
    domain,
    Array.isArray(rules) ? rules : [],
  ] as const);
}
