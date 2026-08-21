-- CreateTable
CREATE TABLE "_TicketBlocks" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_TicketBlocks_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_TicketBlocks_B_index" ON "_TicketBlocks"("B");

-- AddForeignKey
ALTER TABLE "_TicketBlocks" ADD CONSTRAINT "_TicketBlocks_A_fkey" FOREIGN KEY ("A") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TicketBlocks" ADD CONSTRAINT "_TicketBlocks_B_fkey" FOREIGN KEY ("B") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
