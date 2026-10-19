# GhostAudit demo receipts

Start from a clean database: stop the app, delete `server/data`, start it again.
Upload each file (or paste the .txt) as the user shown, in this order.
All results below were checked against the app with no API key (OCR + rules).

| # | Switch to | File | Expected result | What it shows |
|---|---|---|---|---|
| 1 | Alex | 01_green_leaf_cafe.png | Approved $38.50 | Normal claim, paid in full |
| 2 | Alex | 02_corner_bistro.png | Capped, $75 of $92.50 (2.1) | Meal cap |
| 3 | Alex | 02_corner_bistro.png again | Rejected (4.1) | Duplicate detection |
| 4 | Alex | 03_harbour_grill.png | Rejected (3.1) | Glass of Pinot Noir on the bill |
| 5 | Alex | 04_spice_route_team_dinner.png | Approved $195 | Cap is per person: 3 guests x $75 = $225 |
| 6 | Alex | 05_uber_trip.pdf | Capped, $80 of $94.60 (2.2) | Rideshare cap, PDF upload |
| 7 | Alex | 06_qantas_flight.pdf | Rejected (3.2) | $1,450 flight, no pre-approval. The card "Authorization code" on the receipt does not count as approval |
| 8 | Jamie | 06_qantas_flight.pdf | Approved $1,450 | Same flight, but Jamie has a pre-approval from finance |
| 9 | Jamie | 07_figma_subscription.pdf | Approved $45 | Software category |
| 10 | Jamie | 08_bondi_bistro_aud.pdf | Capped, AUD 113.64 of AUD 150 | Foreign currency: $75 USD cap converted to AUD |
| 11 | Jamie | 09_airbnb_email.txt (Paste email tab) | Approved $310 | Pasted email receipt; hotels have no cap |

Then switch to **Taylor (finance)**:
- Show total claimed vs paid, and savings split into caps vs rejections.
- Open the Harbour Grill claim to show the per-rule audit trail.
- Change the 2.1 meal cap (e.g. to $60), switch back to Alex and submit a new meal to show the policy change take effect.
- Record a pre-approval for Alex, then re-upload the Qantas flight as Alex: now approved.

Image uploads take a few seconds the first time while OCR starts up.
