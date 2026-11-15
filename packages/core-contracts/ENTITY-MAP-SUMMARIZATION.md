# Entity map summarization (#407)

Design note for the summarized publish projection of the entity map.

## Problem

The published entity map was a sample. A byte budget decided which nodes survived,
so a large catalogue showed a shrinking fraction of the site as it grew. The large
buckets (hundreds of Brand, Offer or ProductGroup nodes) are structurally identical,
so sampling re-showed one shape and reported the rest as dropped.

## Grouping key

Two nodes are in one group when they share:

- the sorted set of `types`,
- the sorted set of outgoing edge predicates,
- the `pageLocal` flag.

The key is the `signature` string `types#predicates#local|site`. This is a one-step
structural signature, cheaper than full bisimulation and enough to collapse
templated catalogue output. Edge targets are not part of the key.

## Supernode shape

A group is a record in `EntityMap.groups` (`EntityMapGroupSchema`), never an entry
in `nodes`. Fields: `kind: "group"`, `signature`, `types`, `predicates`, `pageLocal`,
`count` (true members in the full map), `occurrences`, `exemplars` (keys), `omitted`.
`count = exemplars.length + omitted`.

Keeping groups out of `nodes` is the contract: a consumer that only reads `nodes`
and `edges` can never render a group as one entity named after many. Consumers
that read `groups` must show a count ("N entities"), as the markdown section does.
The field is optional and additive, so `ENTITY_MAP_VERSION` is unchanged.

## Exemplars

An exemplar is an ordinary node, kept in `nodes` with its edges, so every existing
reader works on it. Up to `summarize.exemplars` members per group are kept, chosen
by reach (occurrences, then degree, then key). Other members are in neither `nodes`
nor `edges`; they count towards `truncated.nodes` and `omitted`. A node carrying a
finding stays eligible through the problem tier even when it is not an exemplar,
and is then listed in `exemplars`.

## Rules read the full map

Rules run on the full map before any projection. `projectEntityMap` never mutates
its input, so verdicts are unchanged by summarization.

## Composition with the caps

Groups of at least `summarize.minGroupSize` members collapse first (publish limits:
8 members, 3 exemplars). Whatever does not summarize goes through the existing
sampling tiers. `maxNodes`, `maxBytes` and `truncated` apply to the emitted nodes
as before. The viewer projection does not summarize; it keeps its own clustering.

## Consumers

- Markdown section and report formats built on it: render an "Entity groups" table.
- Hosted viewer and agent tools read the published map; they receive `groups` as a
  separate array. Rendering support there is a follow-up in the private repo.
