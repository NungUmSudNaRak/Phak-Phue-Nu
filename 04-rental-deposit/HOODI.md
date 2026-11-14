# Deploy บน Ethereum Hoodi

- Chain ID: `560048`
- Compiler: Solidity `0.8.30+commit.73712a01`
- Contract: [`RentalDeposit`](https://eth-hoodi.blockscout.com/address/0x8ac1ACBBCAD8718ecC8C9452fbE81EAefA383362)
- [ธุรกรรม deploy (Success)](https://eth-hoodi.blockscout.com/tx/0x255ecd067dc787cd63ffc71cf4b8d2e46b63c44d1215384b0aaa844ffcabe0f5)
- [ซอร์ส Solidity](contracts/RentalDeposit.sol)

## เปิดสัญญาใน Remix

1. เปิด [Remix](https://app.remix.live/) แล้วคอมไพล์ `RentalDeposit.sol` ด้วย Solidity 0.8.30
2. เปิด Deploy → Environment → Browser Extension → MetaMask และตรวจว่าแสดง Ethereum Hoodi (560048)
3. โหลดสัญญาที่ `0x8ac1ACBBCAD8718ecC8C9452fbE81EAefA383362` ด้วย At Address/Load Contract
4. เรียก `propertyCount()` เพื่อเช็กการเชื่อมต่อแบบอ่านอย่างเดียว

## ขั้นตอนสาธิต

เจ้าของเรียก `registerProperty` และ `createAgreement` จากนั้นทั้งสอง Wallet เรียก `confirmAgreement` ก่อนผู้เช่าฝากด้วย `depositSecurity` โดยส่ง Value เท่ากับเงินประกันในหน่วย wei ผู้เช่าจ่ายตามงวดด้วย `payRent` และอ่านประวัติผ่าน `payments`

หลังหมดสัญญา เจ้าของเรียก `proposeRefund` พร้อมแฮชผลตรวจห้อง หากมีการหักเงินต้องแนบแฮชเหตุผล ผู้เช่าเรียก `acceptRefund` หรือ `openDispute` แล้วให้ผู้ชี้ขาดตามสัญญาเรียก `resolveDispute` เมื่อจัดสรรยอดแล้วแต่ละฝ่ายเรียก `withdraw` ด้วย Wallet ของตน

หลักฐานด้านบนยืนยันการ deploy บน Hoodi การทดสอบธุรกรรมครบวงจรเดิมรันบนเครือข่ายจำลอง
