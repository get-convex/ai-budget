import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Backstop reservation/settlement: fold any finished-but-unfolded requests and
// release reservations for requests that never settled.
crons.interval(
  "reconcile ai gateway spend",
  { minutes: 1 },
  internal.lib.reconcile,
  {}
);

export default crons;
