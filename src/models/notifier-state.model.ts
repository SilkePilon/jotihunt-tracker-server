import mongoose from "mongoose";

/** What the notifier saw last (one document per database), so it only alerts about changes. */
const NotifierStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "notifier" },
    areaStatus: { type: Map, of: String, required: true, default: () => new Map() },
    lastArticleId: { type: Number, required: true, default: 0 },
    /** Lowercase area → ISO time of the hunt whose cooldown end was handled (pushed or skipped). Missing = not seeded yet:
     * that run only records. */
    cooldownNotified: { type: Map, of: String, required: false },
    /** False until the first run stored the current state (that run sends nothing) */
    initialized: { type: Boolean, required: true, default: false },
    /** Bumped on every state change; runs compare-and-set on it so overlapping runs never announce a change twice */
    version: { type: Number, required: true, default: 0 },
  },
  // An empty cooldownNotified means "seeded"; minimizing would drop it
  { minimize: false },
);

export const NotifierState = mongoose.model("NotifierState", NotifierStateSchema);
