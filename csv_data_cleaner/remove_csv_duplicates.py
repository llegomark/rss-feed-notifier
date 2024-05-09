import csv


def clean_csv(input_file, output_file):
    # Dictionary to store unique URLs
    unique_urls = {}

    # Read the input CSV file
    with open(input_file, 'r', encoding='utf-8') as file:
        reader = csv.DictReader(file)

        # Iterate over each row in the CSV
        for row in reader:
            url = row['URL']

            # Check if the URL is already in the dictionary
            if url not in unique_urls:
                unique_urls[url] = row

    # Write the cleaned data to the output CSV file
    with open(output_file, 'w', newline='', encoding='utf-8') as file:
        fieldnames = ['Date', 'Time', 'Title', 'URL']
        writer = csv.DictWriter(file, fieldnames=fieldnames)

        writer.writeheader()

        # Write the unique entries to the output file
        for row in unique_urls.values():
            writer.writerow(row)

    print(f"Cleaned data has been written to {output_file}")


# Specify the input and output file paths
input_file = 'feed-data.csv'
output_file = 'cleaned-data.csv'
clean_csv(input_file, output_file)
