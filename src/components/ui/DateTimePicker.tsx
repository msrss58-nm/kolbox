import { forwardRef, type InputHTMLAttributes } from "react";
import { shift } from "@floating-ui/react";
import { he } from "date-fns/locale";
import DatePicker, { registerLocale } from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import { cn } from "../../lib/utils";
import { fieldClasses } from "./Field";

registerLocale("he", he);

/** react-datepicker clones this element and injects value/onClick/onChange -
 * a forwarded ref lets it manage focus/positioning correctly. Reuses the
 * shared `fieldClasses` so it looks identical to every other text input. */
const DateTimePickerInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    readOnly
    dir="ltr"
    className={cn(fieldClasses, "cursor-pointer text-end", className)}
    {...props}
  />
));
DateTimePickerInput.displayName = "DateTimePickerInput";

/** A styled date+time picker (react-datepicker under the hood, themed to
 * match the app's cards/dropdowns via the `.kb-datepicker*` rules in
 * index.css) - replaces the native `<input type="datetime-local">`, whose
 * browser-default popup couldn't be styled at all.
 *
 * `portalId` (react-datepicker's built-in mechanism, not `withPortal` - that
 * one renders a full-screen centered overlay instead) renders the calendar
 * popover into a body-level portal while keeping it Popper-positioned next
 * to the input. Without it, any caller that nests this component inside an
 * `overflow-hidden`/`overflow-y-auto` ancestor (e.g. `ReminderMenu` inside
 * `Modal`'s scrollable body) silently clips the calendar/time-list - a
 * portal is immune to that regardless of how deeply nested the caller is.
 *
 * `popperModifiers={[shift(...)]}` + `popperProps={{ strategy: "fixed" }}`:
 * react-datepicker's default middleware (`flip` + `offset`, no `shift`)
 * picks whichever side has more room but never clamps the result back
 * inside the viewport - when neither side has the calendar's full ~545px
 * (date grid + time list side by side) available, e.g. an anchor low inside
 * a tall scrollable modal, it still renders at that computed position, off
 * the top of the screen. `strategy: "fixed"` (vs. the default "absolute")
 * makes the coordinates viewport-relative, correct for an element portaled
 * to `document.body` outside its original scroll container. `shift`'s
 * `crossAxis: true` is required, not just `shift(...)` alone - floating-ui's
 * shift() only clamps its "main" axis by default, which for a top/bottom
 * placement is horizontal; our overflow here is vertical (the placement
 * side itself doesn't fit), which floating-ui calls the "cross" axis for
 * top/bottom placements and leaves unclamped unless explicitly opted in -
 * confirmed empirically (a debug middleware logging `detectOverflow`'s raw
 * output showed `overflow.top > 0` correctly detected, but `y` genuinely
 * unchanged, before `crossAxis: true` was added). */
export function DateTimePicker({
  value,
  onChange,
  placeholder,
  className,
  minDate,
}: {
  value: Date | null;
  onChange: (date: Date | null) => void;
  placeholder?: string;
  className?: string;
  /** Optional earliest selectable date (e.g. "today" for a reminder picker,
   * so a past date can't be picked). Omitted = no constraint, unchanged
   * behavior for every existing caller. */
  minDate?: Date;
}) {
  return (
    <DatePicker
      selected={value}
      onChange={onChange}
      showTimeSelect
      timeFormat="HH:mm"
      timeIntervals={15}
      timeCaption="שעה"
      dateFormat="dd/MM/yyyy HH:mm"
      locale="he"
      placeholderText={placeholder}
      shouldCloseOnSelect={false}
      minDate={minDate}
      customInput={<DateTimePickerInput className={className} />}
      calendarClassName="kb-datepicker"
      popperClassName="kb-datepicker-popper"
      popperPlacement="bottom-end"
      portalId="kb-datepicker-portal"
      popperProps={{ strategy: "fixed" }}
      popperModifiers={[shift({ padding: 8, crossAxis: true })]}
    />
  );
}
