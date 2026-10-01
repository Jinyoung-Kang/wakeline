package dev.wakeline.ships.core;

import dev.wakeline.ships.core.DestinationInfo.Place;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * AIS 목적지 풀이(계약 v4 §B): 정규화 · 구분자(between·from_to·to·text) · UN/LOCODE 공백형·붙임형 · 항구만 · ambiguous.
 * 규칙에 맞지 않으면 풀지 않는다(text, locode 없음) — 추정하지 않는다.
 */
class DestinationParserTest {
    final DestinationParser parser = new DestinationParser(UnlocodePortsTest.sample());

    static Place unresolved(String text) { return new Place(text, null, null, null, null, false); }

    static final Place BUSAN = new Place("KR PUS", "KRPUS", "Busan", "KR", "26", false);

    @Test void unknownDestinationIsNull() {
        assertThat(parser.parse(null)).isNull();
        assertThat(parser.parse("")).isNull();
        assertThat(parser.parse("   ")).isNull();
    }

    @Test void normalizesCaseAndSpaces_rawIsKeptAsReported() {
        DestinationInfo d = parser.parse("  kr   pus  ");
        assertThat(d.raw()).isEqualTo("  kr   pus  ");
        assertThat(d.kind()).isEqualTo(DestinationInfo.TEXT);
        assertThat(d.from()).isNull();
        assertThat(d.to()).isEqualTo(BUSAN);
        assertThat(d.places()).containsExactly(BUSAN);
        assertThat(DestinationParser.normalize("a\tb \n c")).isEqualTo("A B C");
    }

    @Test void spacedLocodeAllowsTrailingText_compactMustBeExactlyFiveChars() {
        assertThat(parser.parse("KR PUS BERTH 3").to()).isEqualTo(new Place("KR PUS BERTH 3", "KRPUS", "Busan", "KR", "26", false));
        assertThat(parser.parse("KRPUS").to()).isEqualTo(new Place("KRPUS", "KRPUS", "Busan", "KR", "26", false));
        assertThat(parser.parse("KRPUS 3").to()).as("compact form is exactly 5 chars").isEqualTo(unresolved("KRPUS 3"));
        assertThat(parser.parse("KR PUSAN").to()).as("spaced code is exactly 3 chars before a space").isEqualTo(unresolved("KR PUSAN"));
        assertThat(parser.parse("KR-PUS").to()).isEqualTo(unresolved("KR-PUS"));
        assertThat(parser.parse("JP 8QX").to().locode()).isEqualTo("JP8QX");
        assertThat(parser.parse("SGSIN").to().subdivision()).isNull();
    }

    @Test void onlyPortCodesFromTheTableResolve() {
        assertThat(parser.parse("KRINC").to()).as("not in the ports table").isEqualTo(unresolved("KRINC"));
        assertThat(parser.parse("BUSAN").to()).as("five letters that are not a port code").isEqualTo(unresolved("BUSAN"));
        assertThat(parser.parse("DEDUI").to().name()).as("inland port (8)").isEqualTo("Duisburg");
    }

    @Test void compactCodeThatIsAlsoAPlaceNameIsAmbiguous_spacedIsNot() {
        Place compact = parser.parse("cavan").to();
        assertThat(compact.locode()).isEqualTo("CAVAN");
        assertThat(compact.name()).isEqualTo("Vancouver");
        assertThat(compact.ambiguous()).isTrue();
        assertThat(parser.parse("CA VAN").to().ambiguous()).as("the spaced form is clearly a code").isFalse();
    }

    @Test void separators() {
        DestinationInfo ft = parser.parse("KR PUS > NLRTM");
        assertThat(ft.kind()).isEqualTo(DestinationInfo.FROM_TO);
        assertThat(ft.from()).isEqualTo(BUSAN);
        assertThat(ft.to().locode()).isEqualTo("NLRTM");
        assertThat(ft.places()).extracting(Place::text).containsExactly("KR PUS", "NLRTM");

        DestinationInfo to = parser.parse(">SGSIN");
        assertThat(to.kind()).isEqualTo(DestinationInfo.TO);
        assertThat(to.from()).isNull();
        assertThat(to.to().locode()).isEqualTo("SGSIN");
        assertThat(parser.parse("> SG SIN").places()).extracting(Place::locode).containsExactly("SGSIN");

        for (String s : List.of("KRPUS<=>NLRTM", "KRPUS <> NLRTM", "krpus<=>nlrtm")) {
            DestinationInfo b = parser.parse(s);
            assertThat(b.kind()).as(s).isEqualTo(DestinationInfo.BETWEEN);
            assertThat(b.from()).isNull();
            assertThat(b.to()).isNull();
            assertThat(b.places()).extracting(Place::locode).containsExactly("KRPUS", "NLRTM");
        }
        DestinationInfo free = parser.parse("BUSAN>ROTTERDAM");
        assertThat(free.kind()).isEqualTo(DestinationInfo.FROM_TO);
        assertThat(free.places()).containsExactly(unresolved("BUSAN"), unresolved("ROTTERDAM"));
    }

    @Test void anythingElseIsText() {
        for (String s : List.of("FOR ORDERS", "A>B>C", ">", "KRPUS>", "A<B", "A<>B<>C", "A<=>", "<=>B", "<>B", "A<=>B>C", "A<=>B<=>C", ">>B", "A<>B>C")) {
            DestinationInfo d = parser.parse(s);
            assertThat(d.kind()).as(s).isEqualTo(DestinationInfo.TEXT);
            assertThat(d.from()).as(s).isNull();
            assertThat(d.places()).as(s).hasSize(1);
            assertThat(d.to()).as(s).isEqualTo(d.places().getFirst());
            assertThat(d.to().text()).as(s).isEqualTo(DestinationParser.normalize(s));
        }
        assertThat(DestinationParser.split("A<=>B", "<=>")).containsExactly("A", "B");
        assertThat(DestinationParser.split("AB", "<=>")).isNull();
    }

    @Test void bundledParserUsesTheShippedTable() {
        DestinationInfo d = DestinationParser.bundled().parse("KR PUS");
        assertThat(d.to().name()).isEqualTo("Busan");
        assertThat(DestinationParser.bundled()).isSameAs(DestinationParser.bundled());
    }
}
