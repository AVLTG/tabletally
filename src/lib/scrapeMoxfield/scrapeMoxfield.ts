import "server-only";
import { fetchMoxfieldApi } from "@/lib/moxfieldApi";
import type { MoxfieldCard } from "@/types/moxfield";

export async function scrapeMoxfield({
  collectionId,
}: {
  collectionId: string;
}): Promise<MoxfieldCard[]> {
  console.log("Starting scrape for collection:", collectionId);

  let allCards: MoxfieldCard[] = [];
  let pageNumber = 1;
  let hasMorePages = true;
  const pageSize = 5000;

  while (hasMorePages) {
    const apiUrl = `/v1/collections/search/${collectionId}?sortType=cardName&sortDirection=ascending&pageNumber=${pageNumber}&pageSize=${pageSize}&playStyle=paperDollars&pricingProvider=cardkingdom`;
    console.log(`Fetching page ${pageNumber}...`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apiData = await fetchMoxfieldApi(apiUrl) as { data?: Record<string, any> };

    if (!apiData || !apiData.data) {
      break;
    }

    const pageCards: MoxfieldCard[] = [];

    for (const key of Object.keys(apiData.data)) {
      const item = apiData.data[key];

      if (!item || !item.card) {
        continue;
      }

      const isBasicLand = item.card.type_line?.startsWith("Basic Land");
      const isToken = item.card.type_line?.includes("Token");

      if (isBasicLand || isToken) {
        continue;
      }

      pageCards.push({
        name: item.card.name,
        scryfall_id: item.card.scryfall_id,
        quantity: item.quantity,
        condition: item.condition,
        isFoil: item.isFoil,
        set: item.card.set,
        set_name: item.card.set_name,
        type_line: item.card.type_line || "",
      });
    }

    console.log(`  Got ${pageCards.length} cards from page ${pageNumber}`);
    allCards = allCards.concat(pageCards);

    // "Full page" must be judged on the RAW key count, before basics/tokens
    // are filtered — otherwise any full page containing a basic land looks
    // like a short page and the collection is silently truncated at page 1.
    const rawCount = Object.keys(apiData.data).length;
    hasMorePages = rawCount >= pageSize;
    if (hasMorePages) {
      pageNumber++;
    }
  }

  console.log("Total cards processed:", allCards.length);
  return allCards;
}
