import { ADMIN_ROLES } from "@rcs/shared";
import { reservationPageProps } from "../../../lib/reservation-page";
import { ReservationsClient } from "../../waiter/reservations/reservations-client";

export default async function ReservationsPage() {
  return <ReservationsClient mode="admin" {...await reservationPageProps(ADMIN_ROLES)} />;
}
