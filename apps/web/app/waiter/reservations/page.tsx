import { ReservationsClient } from "./reservations-client";
import { WAITER_ROLES } from "@rcs/shared";
import { reservationPageProps } from "../../../lib/reservation-page";

export default async function ReservationsPage() {
  return <ReservationsClient {...await reservationPageProps(WAITER_ROLES)} />;
}
