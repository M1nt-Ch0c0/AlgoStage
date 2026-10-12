import Link from "next/link";
import { KeyRound } from "lucide-react";

/** 未获取到设置或请求失败时不推断为未配置，避免误导已接入的用户。 */
export default function AiSetupPrompt({ keySource }: { keySource: unknown }) {
  if (keySource !== "none") return null;
  return <Link href="/settings" className="flex items-center gap-1.5 text-beam-gold hover:underline">
    <KeyRound size={14} />还没接上 AI？去设置
  </Link>;
}
