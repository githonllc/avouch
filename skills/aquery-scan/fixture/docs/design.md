# Toolshed design

Toolshed lends power tools to members of a community workshop.

## Tools

A Tool is one physical tool on a shelf. The state of a Tool is IN_STOCK, LENT or RETIRED.
A Tool starts IN_STOCK. Lending a tool moves it to LENT; returning it moves it back to IN_STOCK.
Staff retire a broken tool outside the system.

## Members

A Member is a person registered at the workshop. A Member with a safety_briefing_at older than one year may not rent.
suspended is set by staff when a member may not rent at all.

## Rentals

A Rental records that a Member took a Tool. The state of a Rental is OPEN or CLOSED.
Only staff with the `rental:write` permission may open or close a rental.

### Open a rental

OPEN_RENTAL takes tool_id and member_id. The rules are checked in order and the first match decides:
1. A Tool that is not IN_STOCK is REJECTED.
2. A suspended Member is REJECTED.
3. Otherwise the rental is OPENED: a Rental is created with state OPEN, the Tool becomes LENT, and the event rental.opened is written.

### Close a rental

CLOSE_RENTAL takes rental_id. A Rental that is not OPEN is REJECTED. Otherwise the Rental becomes CLOSED, the Tool becomes IN_STOCK again, and the event rental.closed is written. The result is CLOSED.
