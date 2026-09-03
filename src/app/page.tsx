import HomeClient from "@/components/HomeClient";
import { getCompanies } from "@/lib/supabase-server";

export default async function Home() {
  const companies = await getCompanies();
  return <HomeClient companies={companies} />;
}
