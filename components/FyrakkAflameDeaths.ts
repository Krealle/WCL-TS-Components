import { RpgLogs } from "../definitions/RpgLogs";

getComponent = () => {
  const fyrakkEncounterId = 2677;
  const isFyrakk = reportGroup.fights.every(
    (fight) => fight.encounterId === fyrakkEncounterId
  );
  if (!isFyrakk) {
    return {
      component: "EnhancedMarkdown",
      props: {
        content: `This component only works for <EncounterIcon id="${fyrakkEncounterId}">Fyrakk</EncounterIcon>.`,
      },
    };
  }

  // WoW doesn't provide race information in combatlog so need to set it manually
  const dwarfPlayers = new Set([
    "Ridud",
    "Olgey",
    "Malkrok",
    "Dolanpepe",
    "Sarw",
    "Glyco",
    "Susjo",
    "Skarwi",
  ]);
  // Change this to however anal you wanna be about dispels.
  const gracePeriod = 1_000;

  // WCL doesn't provide their frontend ids so we gotta build our own index.
  let fightIndex = 1;
  const fightIndexMap: Record<number, number> =
    reportGroup.reports[0].fights.reduce((acc, fight) => {
      if (fight.difficulty && fight.endTime - fight.startTime > 8_000) {
        acc[fight.id] = fightIndex;
        fightIndex++;
      }
      return acc;
    }, {} as Record<number, number>);

  const aflameDebuffId = 417807;
  const aflameAbility = reportGroup.abilities.find(
    (x) => x.id === aflameDebuffId
  );

  const stoneformId = 65116;
  const stoneFormCooldown = 120_000;

  const dispelCooldown = 8_000;
  const dispelSpells = new Set([
    527, // Purify
    4987, // Cleanse
    115450, // Detox
    360823, // Naturalize
    88423, // Nature's Cure
    77130, // Purify Spirit
  ]);

  // 115310 - Revival
  // 32375 - Mass Dispel

  const getPlayerMarkdown = (player: RpgLogs.Actor) => {
    return `<${player.subType}>${player.name}</${player.subType}>`;
  };

  const formatTime = (timestamp: number) => {
    const time = Math.trunc(timestamp / 1000);

    const minutes = Math.floor(time / 60);
    const seconds = time % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const stoneFormUsage: Record<number, Record<string, number[]>> = {};
  for (const fight of reportGroup.fights) {
    const events = fight.eventsByCategoryAndDisposition(
      "aurasGained",
      "friendly"
    );
    for (const event of events) {
      if (event.ability?.id !== stoneformId || event.type !== "applybuff")
        continue;
      if (event.ability.id === stoneformId && event.type === "applybuff") {
        const playerName = event.source?.name ?? "Unknown";
        const fId = fight.id;
        if (!stoneFormUsage[fId]) {
          stoneFormUsage[fId] = {};
        }
        if (!stoneFormUsage[fId][playerName]) {
          stoneFormUsage[fId][playerName] = [];
        }
        stoneFormUsage[fId][playerName].push(event.timestamp);
      }
    }
  }

  const dispelUsage: Record<number, Record<string, number[]>> = {};
  for (const fight of reportGroup.fights) {
    const events = fight.eventsByCategoryAndDisposition("dispels", "friendly");
    for (const event of events) {
      if (event.type !== "dispel") continue;
      if (
        event.stoppedAbility.id === aflameDebuffId &&
        dispelSpells.has(event?.ability?.id ?? -1)
      ) {
        const playerName = getPlayerMarkdown(event.source!);
        const fId = fight.id;
        if (!dispelUsage[fId]) {
          dispelUsage[fId] = {};
        }
        if (!dispelUsage[fId][playerName]) {
          dispelUsage[fId][playerName] = [];
        }
        dispelUsage[fId][playerName].push(event.timestamp);
      }
    }
  }

  const deathsAndResses: Record<
    number,
    Record<string, { start: number; end: number }[]>
  > = {};
  for (const fight of reportGroup.fights) {
    const events = fight.eventsByCategoryAndDisposition(
      "deathsAndResurrects",
      "friendly"
    );
    for (const event of events) {
      if (!event.target) continue;
      if (event.target.type === "Player") {
        const playerName = getPlayerMarkdown(event.target);
        const fId = fight.id;
        if (!deathsAndResses[fId]) {
          deathsAndResses[fId] = {};
        }
        if (!deathsAndResses[fId][playerName]) {
          deathsAndResses[fId][playerName] = [];
        }
        if (event.type === "resurrect") {
          const lastDeath = deathsAndResses[fId][playerName].pop();
          deathsAndResses[fId][playerName].push({
            start: lastDeath?.start ?? fight.startTime,
            end: event.timestamp,
          });
        } else {
          deathsAndResses[fId][playerName].push({
            start: event.timestamp,
            end: -1,
          });
        }
      }
    }
  }

  const hadStoneformReady = (
    playerName: string,
    timestamp: number,
    fightId: number
  ) => {
    const playerStoneforms = stoneFormUsage[fightId]?.[playerName];
    if (!playerStoneforms || playerStoneforms.length === 0) {
      return true;
    }
    const lastStoneform = playerStoneforms.sort((a, b) => b - a)[0];

    return lastStoneform + stoneFormCooldown < timestamp;
  };

  const dispelsReady = (timestamp: number, fightId: number) => {
    return Object.keys(dispelUsage[fightId] || {})
      .filter(
        (name) =>
          dispelUsage[fightId][name].every(
            (dispelTimestamp) =>
              dispelTimestamp + dispelCooldown + gracePeriod < timestamp ||
              dispelTimestamp > timestamp
          ) &&
          (deathsAndResses[fightId][name] || []).every(
            (death) =>
              death.start + 1 > timestamp ||
              (death.end < timestamp && death.end > 0)
          )
      )
      .map((name) => {
        const lastDispelled = dispelUsage[fightId][name]
          .filter(
            (dispelTimestamp) => dispelTimestamp + dispelCooldown < timestamp
          )
          .sort((a, b) => b - a)[0];
        const timeSinceLastDispelled = (
          (timestamp - (lastDispelled + dispelCooldown)) /
          1000
        ).toFixed(2);
        return `${name} (${timeSinceLastDispelled}s)`;
      });
  };

  const aflameDeaths: {
    name: string;
    fight: string;
    hadStoneForm: string;
    dispelsAvailable: string[];
    timestamp: string;
  }[] = [];

  reportGroup.fights.forEach((fight) => {
    const deathEvents = fight.friendlyPlayerDeathEvents.filter(
      (ev) => ev.killingAbility?.id === aflameDebuffId
    );

    deathEvents.forEach((event) => {
      if (!event.target) return;
      let hadStoneForm = false;
      const isDwarf = dwarfPlayers.has(event.target.name);
      if (isDwarf) {
        hadStoneForm = hadStoneformReady(
          event.target.name,
          event.timestamp,
          fight.id
        );
      }
      const dispelsAvailable = dispelsReady(event.timestamp, fight.id);

      if (dispelsAvailable.length === 0 && !hadStoneForm) {
        return;
      }

      const killwipe = fight.isKill
        ? `<Kill>Kill ${fightIndexMap[fight.id]}</Kill>`
        : `<Wipe>Wipe ${fightIndexMap[fight.id]}</Wipe>`;
      const fightId = `${killwipe}`;

      aflameDeaths.push({
        name: getPlayerMarkdown(event.target),
        fight: fightId,
        hadStoneForm: isDwarf
          ? hadStoneForm
            ? `<Kill><Icon type="check"></Kill>`
            : `<Wipe><Icon type="close"></Wipe>`
          : "",
        dispelsAvailable,
        timestamp: formatTime(event.timestamp - fight.startTime),
      });
    });
  });

  const title = aflameAbility
    ? `<AbilityIcon id="${aflameAbility.id}" icon="${aflameAbility.icon}" type="${aflameAbility.type}">${aflameAbility.name}</AbilityIcon> Deaths`
    : "Aflame Deaths";

  return {
    component: "Table",
    props: {
      columns: {
        title: {
          header: title,
          columns: {
            name: {
              header: "Player",
            },
            fight: {
              header: "Fight",
            },
            timestamp: {
              header: "Timestamp",
              textAlign: "center",
            },
            hadStoneForm: {
              header: "Stoneform ready",
              textAlign: "center",
            },
            dispelsAvailable: {
              header: "Dispels ready (time available)",
            },
          },
        },
      },
      data: aflameDeaths,
    },
  };
};
