#!/usr/bin/env python3
"""Sample observed hyperlinks, never construct candidate URLs or training labels."""
import argparse
import collections
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlsplit


def select(rows, limit):
    groups = collections.defaultdict(list)
    seen = set()
    excluded = collections.Counter()
    for row in rows:
        url = row['url']
        parsed = urlsplit(url)
        parts = set(re.split(r'[/_-]+', parsed.path.lower()))
        if not row.get('seedUrl') or not row.get('fetchedUrl'):
            excluded['missing_observation'] += 1
            continue
        if url in seen or not parsed.path.strip('/'):
            excluded['duplicate_or_root'] += 1
            continue
        if parts & {'privacy', 'terms', 'cookies', 'login', 'logout', 'account', 'cart', 'checkout', 'feed', 'print'}:
            excluded['out_of_scope'] += 1
            continue
        seen.add(url)
        groups[row['familyHint']].append(row)
    for values in groups.values():
        values.sort(key=lambda r: hashlib.sha256(r['url'].encode()).hexdigest())
    chosen = []
    hosts = collections.Counter()
    families = collections.Counter()
    # Balance URL families for acquisition only. Teachers later determine page types.
    while len(chosen) < limit:
        changed = False
        for family in sorted(groups):
            values = groups[family]
            while values:
                row = values.pop()
                host = urlsplit(row['url']).hostname
                if hosts[host] >= 6 or families[family] >= max(1, limit // 4):
                    continue
                chosen.append(row)
                hosts[host] += 1
                families[family] += 1
                changed = True
                break
            if len(chosen) == limit:
                break
        if not changed:
            break
    return chosen, {'selected': len(chosen), 'hosts': len(hosts), 'familyHintsNotLabels': dict(families), 'excluded': dict(excluded)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--limit', type=int, default=800)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.input.read_text().splitlines() if line.strip()]
    chosen, summary = select(rows, args.limit)
    args.output.mkdir(parents=True, exist_ok=True)
    with (args.output / 'observed-source-map.jsonl').open('x') as handle:
        for row in chosen:
            handle.write(json.dumps(row) + '\n')
    for index in range(0, len(chosen), 200):
        with (args.output / f'observed-cloud-{index // 200 + 1}.jsonl').open('x') as handle:
            for row in chosen[index:index + 200]:
                handle.write(json.dumps({'url': row['url'], 'corpusRef': 'cloud-runs:observed-hyperlink:' + row['candidateId']}) + '\n')
    (args.output / 'queue-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary))
