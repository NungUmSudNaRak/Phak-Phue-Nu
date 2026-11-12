// Default contract for the page. You can also open the page with
// ?address=0x...&fromBlock=123, or type the address into the Contract box;
// the last address used is remembered in this browser.
export const CONFIG = {
  contractAddress: "",
  // Block the contract was deployed in. Event history is read from here,
  // which keeps the query small on public networks such as Sepolia.
  fromBlock: 0,
};
