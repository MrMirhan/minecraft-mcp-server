import { z } from "zod";
import { ToolFactory } from '../tool-factory.js';
import { ActorsClient } from '../actors-client.js';

// paper-actors: fake players inside a Paper test server (no client, no connection), driven over the plugin's signed API.
// They do not need the Java bot, so they skip its connection check.

const ACTIONS = `Actions (do, with its fields):
- moving: walk {forward -1..1, strafe -1..1, seconds, jump, sprint}, stroll {x, z, sprint}, goto {x, y, z, within, sprint} (pathfinding around walls, up steps, down drops), jump, sneak {on}, look {x, y, z}, watch {target, seconds}, teleport {x, y, z}, idle {seconds}, stop
- fighting: fight {target, style 1.8|1.9, seconds}, attack {target}, swing
- hands: select {slot 0-8}, equip {item, slot}, use (right click the held item), use_on {x, y, z, face} (open a chest, press a button, open a sign), place {x, y, z} (the held block, against a neighbour), break {x, y, z} (digs for as long as survival takes), interact {target: a player name or an entity type such as villager}, drop {stack}, swap_hands
- the open screen: click {slot, type left|right|shift|shift_right|number (hotbar 1-9)|offhand|middle|drop|drop_stack|double|pickup_all|outside_left|outside_right}, drag {slots, button left|right|middle}, close, button {id} (enchanting, stonecutter, loom, lectern), rename {name} (anvil), trade {index}, sign {x, y, z, lines, front}
- talking: chat {text}, command {command} (as the actor, with its own permissions)
Everything goes through the server's packet handlers, so plugins see a real player's events.`;

export function registerActorsTools(factory: ToolFactory, client: ActorsClient): void {
  const skip = { skipConnectionCheck: true };
  const json = (o: unknown) => factory.createResponse(JSON.stringify(o, null, 1));

  factory.registerTool(
    "actors-state",
    "paper-actors: the actors on the Paper test server (name, place, health, what each does) and whether a scene runs. Fake players inside the server: no client, no network.",
    {},
    async () => json(await client.state()),
    skip
  );

  factory.registerTool(
    "actors-spawn",
    "Spawn fake players on the Paper test server. One: name. A crowd: count with prefix (Bot001, Bot002, ...) or names; they join a few per tick, and spread places each within that many blocks of at. Fields for all: at [x, y, z], world, profile (rookie, mid, tryhard: how human the aim is), skin, seed, view (view distance 2-32; keep it small for crowds: the world kept loaded around each actor is most of its cost).",
    {
      name: z.string().optional(),
      count: z.number().int().min(1).max(1000).optional(),
      prefix: z.string().optional(),
      names: z.array(z.string()).optional(),
      at: z.array(z.number()).length(3).optional(),
      world: z.string().optional(),
      spread: z.number().min(0).max(1000).optional(),
      profile: z.enum(['rookie', 'mid', 'tryhard']).optional(),
      skin: z.string().optional(),
      seed: z.string().optional(),
      view: z.number().int().min(2).max(32).optional()
    },
    async (args: Record<string, unknown>) => {
      if (!args.name && !args.count && !args.names) throw new Error('Give name, count (with prefix) or names');
      return json(await client.spawn(Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))));
    },
    skip
  );

  factory.registerTool(
    "actors-despawn",
    "Remove actors: one by name, all with a name prefix, or all.",
    { name: z.string().optional(), prefix: z.string().optional(), all: z.boolean().optional() },
    async ({ name, prefix, all }: { name?: string; prefix?: string; all?: boolean }) => {
      if (!name && !prefix && !all) throw new Error('Give name, prefix or all: true');
      return json(await client.despawn(all ? { all: true } : prefix ? { prefix } : { name }));
    },
    skip
  );

  factory.registerTool(
    "actors-act",
    `Make an actor do something. action is {do, ...fields}. A long action (goto, break, fight, walk, stroll, watch, idle) runs over ticks: follow it with actors-actor (task) or actors-events (done, error). ${ACTIONS}`,
    { name: z.string(), action: z.record(z.string(), z.unknown()) },
    async ({ name, action }: { name: string; action: Record<string, unknown> }) => {
      if (typeof action.do !== 'string') throw new Error('action needs do, e.g. {"do": "goto", "x": 10, "y": 64, "z": 5}');
      await client.act(name, action);
      return factory.createResponse(`${name}: ${action.do} sent.`);
    },
    skip
  );

  factory.registerTool(
    "actors-actor",
    "One actor in detail, to check what an action did: position, health, food, game mode, held slot, inventory (item, count, name, lore), the open screen (type, title, its slots in click numbering, the item on the cursor) and its current task.",
    { name: z.string() },
    async ({ name }: { name: string }) => json(await client.actor(name)),
    skip
  );

  factory.registerTool(
    "actors-metrics",
    "How the server holds up: TPS (1, 5, 15 min), tick times of the last 100 ticks (avg, p95, max ms; 50 ms is the budget of a tick), loaded chunks and entities per world, players, heap, and the actors spawned and waiting. Read it before and after a crowd to measure its cost.",
    {},
    async () => json(await client.metrics()),
    skip
  );

  factory.registerTool(
    "actors-events",
    "What happened, in order: spawned, despawned, done (an action finished), error, hit, death, and a scene's start, ready and end. since takes the last id seen.",
    { since: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional() },
    async ({ since = 0, limit = 200 }: { since?: number; limit?: number }) => json(await client.events(since, limit)),
    skip
  );

  factory.registerTool(
    "actors-scene-play",
    "Play a scripted scene: {actors [{name, at, profile, skin}], duration (s), settle (s), seed, tickRate, setup [commands], cleanup [commands], timeline [{t, actor, do, ...}]}. The same seed gives the same take. Setup and cleanup commands run only when the plugin allows them (scene-commands).",
    { scene: z.record(z.string(), z.unknown()) },
    async ({ scene }: { scene: Record<string, unknown> }) => json(await client.scenePlay(scene)),
    skip
  );

  factory.registerTool(
    "actors-scene-stop",
    "Stop the running scene; its actors leave and cleanup runs.",
    {},
    async () => json(await client.sceneStop()),
    skip
  );
}
