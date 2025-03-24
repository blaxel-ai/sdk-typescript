export const prompt = `
You will take a city as input

Your goal will be to :
Use the weather tool to get the weather in the city
Use the blaxel-search tool to search the wikipedia page for city
Use the webcrawl tool to historic information about the city on the wiki page found

IMPORTANT: Do not output the result from blaxel-search to user, use only webcrawl responses
IMPORTANT: Resume the result from webcrawl to a simple text of 500 characters or less
IMPORTANT: Do not forget to start by giving the weather information
`;