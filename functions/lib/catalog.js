/* Known Vekoma manuals for the Phoenix (IB 45032).
   Matched against the file name in Storage (manuals/...). Anything that doesn't
   match is still indexed, under its file name, so new uploads are searchable. */

export const KNOWN_MANUALS = [
  {
    id: "OMM",
    match: /OMM_45032/i,
    title: "Operation & Maintenance Manual (OMM_45032)",
    short: "Operation manual",
    covers: "Ride operation, start-up/shutdown, functional and weekly tests, E-stop reset, evacuation, " +
            "maintenance procedures for track equipment (boosters, EC brakes, gates, current collectors, " +
            "pneumatics) and train (axles, wheel carriers, wheels, yoke coupling, restraints), NDT, wear " +
            "rejection rules (§7.3), anchor nut torques (§7.5), special tools, logbook and maintenance schedules (§8).",
  },
  {
    id: "PRT",
    match: /PRT_45032/i,
    title: "Parts List (PRT_45032)",
    short: "Parts list",
    covers: "Track and train assembly drawings. Each drawing has a parts table: ITEM, QTY, TITLE, MATERIAL, " +
            "SPECIFICATION, DRAWING, PART NR (7-digit order number). Drawings also carry torque values, " +
            "adhesive notes and critical wear rejection dimensions.",
  },
  {
    id: "DIA",
    match: /DIA_45032/i,
    title: "Diagrams (DIA_45032)",
    short: "Diagrams",
    covers: "As-built electrical drawings (RCS, emergency power pack, coach connection box, restraint, " +
            "junction box) and pneumatic drawings. Device tags like -55Q1, -X34F, wire sizes, breaker " +
            "ratings, PLC I/O, and component lists with manufacturer catalogue numbers.",
  },
  {
    id: "TS",
    match: /TS_DOKU|DOKU-08/i,
    title: "Vekoma Technical Specifications (DOKU-08)",
    short: "Technical specifications",
    covers: "Vekoma general standards: TS-G01 Fasteners (tightening procedure, lubrication, torque striping, " +
            "retorque rules, standard torque tables 1-4 for 8.8 / 10.9 / stainless / HV bolts — the tables " +
            "are images), TS-G05 bushes, TS-G09/G10 pneumatic pressures and start-up, TS-L03 pastes and " +
            "lubricants, TS-C adhesives and potting, TS-S01 paint.",
  },
  {
    id: "OEM",
    match: /OEM_45032/i,
    title: "OEM Documentation (OEM_45032)",
    short: "OEM documentation",
    covers: "Supplier manuals for bought-in equipment: air compressor (filters, belts, oil, safety valve), " +
            "air dryer, pneumatic components, bearings and other third-party parts.",
  },
];

/** Map a Storage path like "manuals/Manual_OMM_45032_EN_01.pdf" to catalog info. */
export function describeManual(storagePath) {
  const file = storagePath.split("/").pop();
  const known = KNOWN_MANUALS.find((m) => m.match.test(file));
  if (known) {
    return { id: known.id, title: known.title, short: known.short, covers: known.covers, file, path: storagePath };
  }
  const base = file.replace(/\.pdf$/i, "");
  const id = base.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase().slice(0, 24);
  return { id, title: base, short: base, covers: "Additional reference document.", file, path: storagePath };
}
