import mongoose from "mongoose";

/** One user's AI chat about one Intel item (private; "Nieuw gesprek" deletes it). Messages are AI SDK UIMessages. */
const IntelChatSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    articleId: { type: Number, required: true },
    messages: { type: [mongoose.Schema.Types.Mixed], default: () => [] },
    updatedAt: { type: Date, required: true },
  },
  { minimize: false },
);

IntelChatSchema.index({ userId: 1, articleId: 1 }, { unique: true });

export const IntelChat = mongoose.model("IntelChat", IntelChatSchema);
