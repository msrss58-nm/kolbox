import { useMemo, useState, type FormEvent } from "react";
import { Button } from "../../components/ui/Button";
import { Field, Input, Select } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { COMMON_TEXT } from "../../constants/common-text";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { isValidIsraeliId } from "../../lib/israeliId";
import { api } from "../../services/api";
import type { PollingStation, Voter } from "../../types";
import { ADD_VOTER_TEXT, VOTERS_TEXT } from "./voters.constants";

const CURRENT_YEAR = new Date().getFullYear();
const MIN_VOTING_AGE = 17;

export function AddVoterModal({
  open,
  onClose,
  cities,
  stations,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  cities: string[];
  stations: PollingStation[];
  onAdded: (voter: Voter) => void;
}) {
  const [nationalId, setNationalId] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [city, setCity] = useState("");
  const [street, setStreet] = useState("");
  const [houseNumber, setHouseNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [stationId, setStationId] = useState("");
  const [touchedId, setTouchedId] = useState(false);

  const cityStations = useMemo(
    () => stations.filter((s) => !city || s.city === city),
    [stations, city],
  );

  const idError =
    touchedId && nationalId && !isValidIsraeliId(nationalId)
      ? ADD_VOTER_TEXT.errors.invalidId
      : undefined;

  const year = Number(birthYear);
  const yearError =
    birthYear && (year < 1900 || year > CURRENT_YEAR - MIN_VOTING_AGE)
      ? ADD_VOTER_TEXT.errors.invalidBirthYear
      : undefined;

  const valid =
    isValidIsraeliId(nationalId) &&
    firstName.trim() &&
    lastName.trim() &&
    city &&
    stationId &&
    !yearError;

  const reset = () => {
    setNationalId("");
    setFirstName("");
    setLastName("");
    setCity("");
    setStreet("");
    setHouseNumber("");
    setPhone("");
    setBirthYear("");
    setStationId("");
    setTouchedId(false);
  };

  const { run: addVoter, busy: submitting } = useAsyncAction(
    () =>
      api.addVoter({
        nationalId: nationalId.trim().padStart(9, "0"),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        city,
        street: street.trim(),
        houseNumber: Number(houseNumber) || 0,
        phone: phone.trim() || null,
        birthYear: year || 1980,
        pollingStationId: stationId,
      }),
    {
      successMessage: (voter) =>
        VOTERS_TEXT.toast.voterAdded(`${voter.firstName} ${voter.lastName}`),
    },
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || submitting) return;
    const voter = await addVoter();
    if (voter) {
      onAdded(voter);
      reset();
      onClose();
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={ADD_VOTER_TEXT.modalTitle} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={ADD_VOTER_TEXT.fields.nationalId} error={idError}>
            <Input
              value={nationalId}
              onChange={(e) =>
                setNationalId(e.target.value.replace(/\D/g, "").slice(0, 9))
              }
              onBlur={() => setTouchedId(true)}
              placeholder={ADD_VOTER_TEXT.placeholders.nationalId}
              inputMode="numeric"
              invalid={!!idError}
              required
            />
          </Field>
          <Field label={ADD_VOTER_TEXT.fields.phone}>
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={ADD_VOTER_TEXT.placeholders.phone}
              inputMode="tel"
              dir="ltr"
            />
          </Field>
          <Field label={ADD_VOTER_TEXT.fields.firstName}>
            <Input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
            />
          </Field>
          <Field label={ADD_VOTER_TEXT.fields.lastName}>
            <Input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              required
            />
          </Field>
          <Field label={ADD_VOTER_TEXT.fields.city}>
            <Select
              value={city}
              onChange={(e) => {
                setCity(e.target.value);
                setStationId("");
              }}
              required
            >
              <option value="">{ADD_VOTER_TEXT.placeholders.pickCity}</option>
              {cities.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={ADD_VOTER_TEXT.fields.station}>
            <Select
              value={stationId}
              onChange={(e) => setStationId(e.target.value)}
              disabled={!city}
              required
            >
              <option value="">
                {city
                  ? ADD_VOTER_TEXT.placeholders.pickStation
                  : ADD_VOTER_TEXT.placeholders.pickCityFirst}
              </option>
              {cityStations.map((s) => (
                <option key={s.id} value={s.id}>
                  קלפי {s.number} · {s.address}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={ADD_VOTER_TEXT.fields.street}>
            <Input value={street} onChange={(e) => setStreet(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label={ADD_VOTER_TEXT.fields.houseNumber}>
              <Input
                value={houseNumber}
                onChange={(e) => setHouseNumber(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
              />
            </Field>
            <Field label={ADD_VOTER_TEXT.fields.birthYear} error={yearError}>
              <Input
                value={birthYear}
                onChange={(e) =>
                  setBirthYear(e.target.value.replace(/\D/g, "").slice(0, 4))
                }
                placeholder={ADD_VOTER_TEXT.placeholders.birthYear}
                inputMode="numeric"
                invalid={!!yearError}
              />
            </Field>
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <Button type="submit" loading={submitting} disabled={!valid} className="flex-1">
            {ADD_VOTER_TEXT.submit}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            {COMMON_TEXT.cancel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
