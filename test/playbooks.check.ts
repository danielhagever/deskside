import { PLAYBOOKS } from "../src/playbooks";
let problems = 0;
for (const [key, pb] of Object.entries(PLAYBOOKS)) {
  const ids = Object.keys(pb.nodes);
  if (!pb.nodes[pb.start]) { console.log(key, "missing start"); problems++; }
  const seen = new Set<string>();
  const stack = [pb.start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = pb.nodes[id];
    if (!n) { console.log(key, "dangling", id); problems++; continue; }
    if (!n.outcome && !n.answers) { console.log(key, "dead end", id); problems++; }
    if (n.check && !n.answers?.continue) { console.log(key, "check without continue", id); problems++; }
    for (const t of Object.values(n.answers ?? {})) stack.push(t);
  }
  const unreachable = ids.filter((i) => !seen.has(i));
  if (unreachable.length) { console.log(key, "unreachable", unreachable); problems++; }
  // every reachable node must eventually be able to reach an outcome
  const canEnd = new Set(ids.filter((i) => pb.nodes[i].outcome));
  let grew = true;
  while (grew) { grew = false; for (const i of ids) if (!canEnd.has(i) && Object.values(pb.nodes[i].answers ?? {}).some((t) => canEnd.has(t))) { canEnd.add(i); grew = true; } }
  const stuck = [...seen].filter((i) => !canEnd.has(i));
  if (stuck.length) { console.log(key, "cannot finish from", stuck); problems++; }
  console.log(key, `${ids.length} nodes, ${[...seen].length} reachable, outcomes: ${ids.filter((i) => pb.nodes[i].outcome).join(",")}`);
}
console.log(problems ? `PROBLEMS: ${problems}` : "ALL PLAYBOOKS SOUND");
